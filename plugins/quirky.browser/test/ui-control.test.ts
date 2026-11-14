import { readFileSync } from 'node:fs'
import { expect, test } from 'bun:test'
import type { UiPluginContext } from '@quirky/protocol'
import * as controls from '../src/ui-control'

const command = 'command:quirky.browser/paneUiControl'
const actions = ['open-find', 'dismiss-message', 'retry-watch', 'retry-native', 'dismiss-page-error', 'close-browser-menu', 'close-history-menu']
const context = () => ({} as UiPluginContext)

test('declares the hidden pane command and its public address', () => {
  const manifest = JSON.parse(readFileSync(new URL('../quirky-plugin.json', import.meta.url), 'utf8'))
  const entry = manifest.contributes.command.find((entry: { id: string }) => entry.id === 'paneUiControl')
  expect(entry).toMatchObject({ palette: false, args: { additionalProperties: false, required: ['action', 'pane'], properties: { pane: { type: 'string' }, action: { enum: actions } } } })
})

test('delivers only to the addressed pane and isolates contexts', () => {
  const ctx = context()
  const first: unknown[] = [], second: unknown[] = []
  controls.registerPaneUiController(ctx, 'pane-1', args => first.push(args))
  controls.registerPaneUiController(ctx, 'pane-2', args => second.push(args))
  const args = { action: 'open-find', pane: 'pane-2' } as const
  expect(controls.dispatchPaneUiControl(ctx, args)).toEqual({ ...args, delivered: 1 })
  expect(first).toEqual([])
  expect(second).toEqual([args])
  expect(controls.dispatchPaneUiControl(context(), args)).toEqual({ ...args, delivered: 0 })
})

test('counts registrations and removes only the cleaned registration', () => {
  const ctx = context()
  const calls: unknown[] = []
  const handler = (args: unknown) => { calls.push(args) }
  const cleanup = controls.registerPaneUiController(ctx, 'pane-1', handler)
  controls.registerPaneUiController(ctx, 'pane-1', handler)
  const args = { action: 'open-find', pane: 'pane-1' } as const
  expect(controls.dispatchPaneUiControl(ctx, args)).toEqual({ ...args, delivered: 2 })
  expect(calls).toEqual([args, args])
  cleanup()
  cleanup()
  expect(controls.dispatchPaneUiControl(ctx, args)).toEqual({ ...args, delivered: 1 })
})

test('reports unknown and unmounted panes without delivery', () => {
  const ctx = context()
  const calls: unknown[] = []
  controls.registerPaneUiController(ctx, 'pane-3', args => calls.push(args))()
  for (const pane of ['pane-3', 'pane-9']) {
    expect(controls.dispatchPaneUiControl(ctx, { action: 'open-find', pane })).toEqual({ action: 'open-find', pane, delivered: 0 })
  }
  expect(calls).toEqual([])
})

test('rejects malformed requests without invoking controllers', () => {
  const ctx = context()
  const calls: unknown[] = []
  controls.registerPaneUiController(ctx, 'pane-1', args => calls.push(args))
  for (const args of [undefined, null, 'open-find', {}, { pane: 'pane-1' }, { action: 'explode', pane: 'pane-1' }, { action: 'open-find', pane: '' }, { action: 'open-find', pane: 7 }]) {
    expect(() => controls.dispatchPaneUiControl(ctx, args)).toThrow('Browser pane control needs a known action and a non-empty pane id.')
  }
  expect(calls).toEqual([])
})

test('drops unused keys before delivering a request', () => {
  const ctx = context()
  const calls: unknown[] = []
  controls.registerPaneUiController(ctx, 'pane-1', args => calls.push(args))
  controls.dispatchPaneUiControl(ctx, { action: 'retry-watch', pane: 'pane-1', extra: 1 })
  expect(calls).toEqual([{ action: 'retry-watch', pane: 'pane-1' }])
})

test('requests the literal command without activating its owner and preserves failures', async () => {
  const calls: unknown[] = []
  const ctx = { executeCommand: async (...args: unknown[]) => { calls.push(args) } } as unknown as UiPluginContext
  const args = { action: 'dismiss-message', pane: 'pane-1' } as const
  await controls.requestPaneUiControl(ctx, args)
  expect(calls).toEqual([[command, args, { activateOwner: false }]])
  const failure = new Error('No command')
  const rejected = { executeCommand: async () => { throw failure } } as unknown as UiPluginContext
  await expect(controls.requestPaneUiControl(rejected, args)).rejects.toBe(failure)
  expect(controls.browserPaneControlInstance('pane-1', 'import-hint')).toBe('browser-pane:pane-1:import-hint')
})
