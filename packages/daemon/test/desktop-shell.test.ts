import { afterEach, expect, test } from 'bun:test'
import type { QuirkyClient, QuirkyEvent } from '@quirky/protocol'
import type { Harness } from './helpers'
import { builtinsDir, makeTempHome, startHarness } from './helpers'

let harness: Harness | undefined

afterEach(async () => {
  if (harness) await harness.cleanup()
  harness = undefined
})

function waitForShellRequest(client: QuirkyClient): Promise<Extract<QuirkyEvent, { type: 'desktop.shell.request' }>> {
  const { promise, resolve } = Promise.withResolvers<Extract<QuirkyEvent, { type: 'desktop.shell.request' }>>()
  const unsubscribe = client.onEvent((event) => {
    if (event.type !== 'desktop.shell.request') return
    unsubscribe()
    resolve(event)
  })
  return promise
}

function waitForUiCommand(client: QuirkyClient): Promise<Extract<QuirkyEvent, { type: 'ui.command.request' }>> {
  const { promise, resolve } = Promise.withResolvers<Extract<QuirkyEvent, { type: 'ui.command.request' }>>()
  const unsubscribe = client.onEvent((event) => {
    if (event.type !== 'ui.command.request') return
    unsubscribe()
    resolve(event)
  })
  return promise
}

test('directory-picker result is returned to the requester only from its selected native shell', async () => {
  harness = await startHarness({ home: makeTempHome('quirky-desktop-route-'), builtinPluginsDir: builtinsDir() })
  const requester = await harness.connect('cli')
  const owner = await harness.connect('ui')
  const other = await harness.connect('ui')
  await owner.call('desktop.shell.capabilities', {
    directoryPicker: true, auxiliaryWindows: true, revealItem: true,
    notifications: { permission: false, click: false, dismiss: false }
  })
  await other.call('desktop.shell.capabilities', {
    directoryPicker: true, auxiliaryWindows: true, revealItem: true,
    notifications: { permission: false, click: false, dismiss: false }
  })
  await owner.call('ui.window.focused', { focused: true })

  const requestEvent = waitForShellRequest(owner)
  const resultPending = requester.call('desktop.folder.pick', { title: 'Choose a workspace', startingFolder: '/tmp', multiple: false })
  const request = await requestEvent
  expect(request.action).toEqual({ kind: 'folder-picker', request: { title: 'Choose a workspace', startingFolder: '/tmp', multiple: false } })

  await other.call('desktop.shell.reply', { requestId: request.requestId, result: { cancelled: false, paths: ['/wrong-window'] } })
  await owner.call('desktop.shell.reply', { requestId: request.requestId, result: { cancelled: true, paths: [] } })
  await expect(resultPending).resolves.toEqual({ cancelled: true, paths: [] })
})

test('unavailable directory selection refuses instead of routing to a non-capable or local substitute', async () => {
  harness = await startHarness({ home: makeTempHome('quirky-desktop-unavailable-'), builtinPluginsDir: builtinsDir() })
  const requester = await harness.connect('cli')
  const webWindow = await harness.connect('ui')
  await webWindow.call('desktop.shell.capabilities', {
    directoryPicker: false, auxiliaryWindows: false, revealItem: false,
    notifications: { permission: false, click: false, dismiss: false }
  })

  await expect(requester.call('desktop.folder.pick', {})).rejects.toThrow(/no capable native desktop window supports directory selection/)
})

test('auxiliary routes remain daemon-readable, local to their window, and pruned by the native owner close', async () => {
  harness = await startHarness({ home: makeTempHome('quirky-desktop-window-'), builtinPluginsDir: builtinsDir() })
  const requester = await harness.connect('cli')
  const shell = await harness.connect('ui')
  await shell.call('desktop.shell.capabilities', {
    directoryPicker: true, auxiliaryWindows: true, revealItem: true,
    notifications: { permission: false, click: false, dismiss: false }
  })
  const model = await requester.call('ui.contributions', {})
  const view = model.views[0]
  expect(view).toBeDefined()
  const initialLayout = (await requester.call('ui.state', {})).layout

  const requestEvent = waitForShellRequest(shell)
  const resultPending = requester.call('desktop.window.open', {
    view: view.id, input: { filter: { hidden: false }, selectedGroup: 'ready' }, title: 'Dashboard pop-out'
  })
  const request = await requestEvent
  expect(request.action).toEqual({
    kind: 'window-open',
    request: { view: view.id, input: { filter: { hidden: false }, selectedGroup: 'ready' }, title: 'Dashboard pop-out' }
  })
  const ownerShellConnId = request.ownerShell.connId
  await shell.call('desktop.shell.reply', { requestId: request.requestId, result: { windowId: 'owned-window-7' } })
  await expect(resultPending).resolves.toEqual({ windowId: 'owned-window-7' })
  expect(await requester.call('desktop.window.list', {})).toEqual([{
    windowId: 'owned-window-7', view: view.id, input: { filter: { hidden: false }, selectedGroup: 'ready' },
    title: 'Dashboard pop-out', ownerShell: request.ownerShell, attached: false
  }])

  const auxiliary = await harness.connect('ui')
  await expect(auxiliary.call('desktop.window.attach', {
    windowId: 'owned-window-7', ownerShellConnId: ownerShellConnId + 1
  })).rejects.toThrow(/owner does not match/)
  await auxiliary.call('desktop.window.attach', { windowId: 'owned-window-7', ownerShellConnId })
  await auxiliary.call('ui.window.focused', { focused: true })
  await auxiliary.call('ui.report', { slot: view.id, state: { shown: true, filter: 'ready' } })
  const nextInput = { filter: { hidden: true }, selectedGroup: 'review' }
  await auxiliary.call('desktop.window.update', { windowId: 'owned-window-7', view: view.id, input: nextInput })
  expect(await requester.call('desktop.window.list', {})).toMatchObject([{
    windowId: 'owned-window-7', view: view.id, input: nextInput, attached: true
  }])
  const updatedUiState = await requester.call('ui.state', {})
  expect(updatedUiState.layout).toEqual(initialLayout)
  expect(updatedUiState.slots.find((slot) => slot.id === view.id)?.shown).toBe(true)
  expect(updatedUiState.slots.find((slot) => slot.id === view.id)?.report).toEqual({ shown: true, filter: 'ready' })
  const command = model.commands[0]
  expect(command).toBeDefined()
  const otherWindow = await harness.connect('ui')
  let wrongOwnerReceivedCommand = false
  otherWindow.onEvent((event) => {
    if (event.type === 'ui.command.request') wrongOwnerReceivedCommand = true
  })
  await otherWindow.call('ui.window.focused', { focused: true })
  const ownerRequest = waitForUiCommand(shell)
  const ownerCommand = auxiliary.call('desktop.window.runOwnerCommand', {
    windowId: 'owned-window-7', id: command.id, args: {}
  })
  const routed = await ownerRequest
  expect(routed.id).toBe(command.id)
  await shell.call('ui.command.reply', { requestId: routed.requestId, result: { opened: true } })
  const activationRequest = await waitForShellRequest(auxiliary)
  expect(activationRequest.action).toEqual({ kind: 'window-activate-owner', request: { windowId: 'owned-window-7' } })
  await auxiliary.call('desktop.shell.reply', { requestId: activationRequest.requestId, result: { activated: true } })
  await expect(ownerCommand).resolves.toEqual({ result: { opened: true }, activated: true })
  expect(wrongOwnerReceivedCommand).toBe(false)

  const nativeDesktop = await harness.connect('desktop')
  await expect(nativeDesktop.call('desktop.window.closed', {
    windowId: 'owned-window-7', ownerShellConnId: ownerShellConnId + 1
  })).resolves.toEqual({ closed: false })
  expect(await requester.call('desktop.window.list', {})).toHaveLength(1)
  await expect(nativeDesktop.call('desktop.window.closed', {
    windowId: 'owned-window-7', ownerShellConnId
  })).resolves.toEqual({ closed: true })
  expect(await requester.call('desktop.window.list', {})).toEqual([])
})

test('notification callbacks remain unavailable when the SDK exposes no acknowledgement hooks', async () => {
  harness = await startHarness({ home: makeTempHome('quirky-desktop-notify-'), builtinPluginsDir: builtinsDir() })
  const requester = await harness.connect('cli')
  const capabilities = await requester.call('desktop.capabilities', {})
  expect(capabilities.notifications).toEqual({ permission: false, click: false, dismiss: false })
})
