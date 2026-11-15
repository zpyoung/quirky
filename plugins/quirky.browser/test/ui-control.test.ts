import { readFileSync } from 'node:fs'
import { expect, test } from 'bun:test'
import type { UiPluginContext } from '@quirky/protocol'
import * as controls from '../src/ui-control'

const command = 'command:quirky.browser/paneUiControl'
const actions = ['open-find', 'dismiss-message', 'retry-watch', 'retry-native', 'dismiss-page-error', 'close-browser-menu', 'close-history-menu']
const designCommand = 'command:quirky.browser/designControl'
const designActions = [
  'toggle-grab', 'toggle-annotate', 'draw', 'copy-selection', 'copy-selection-screenshot',
  'select-another', 'cancel-selection', 'set-intent', 'save-annotation', 'close-annotation',
  'edit-annotation', 'delete-annotation', 'copy-annotation', 'toggle-annotations', 'open-targets',
  'close-targets', 'copy-annotations', 'clear-annotations', 'send-annotations', 'markup-tool',
  'markup-undo', 'markup-redo', 'markup-clear', 'markup-close', 'markup-copy'
] as const
const markupTools = ['pen', 'highlighter', 'arrow', 'rectangle', 'ellipse', 'text', 'eraser'] as const
type DesignArgs = {
  action: typeof designActions[number]
  pane: string
  annotation?: number
  intent?: 'change' | 'question'
  session?: string
  agent?: string
  tool?: typeof markupTools[number]
}
type DesignControlApi = {
  DESIGN_CONTROL_COMMAND: string
  DESIGN_CONTROL_ACTIONS: readonly string[]
  MARKUP_TOOLS: readonly string[]
  registerDesignController(context: UiPluginContext, pane: string, handler: (args: DesignArgs) => void): () => void
  registerMarkupController(context: UiPluginContext, pane: string, handler: (args: DesignArgs) => void): () => void
  dispatchDesignControl(context: UiPluginContext, args: unknown): { pane: string; action: typeof designActions[number]; delivered: number }
  requestDesignControl(context: UiPluginContext, args: DesignArgs): Promise<void>
}
const designControls = controls as typeof controls & DesignControlApi

test('declares the hidden design command and its complete payload contract', () => {
  const manifest = JSON.parse(readFileSync(new URL('../quirky-plugin.json', import.meta.url), 'utf8'))
  const entry = manifest.contributes.command.find((entry: { id: string }) => entry.id === 'designControl')
  expect(entry).toEqual({
    id: 'designControl',
    title: 'Browser Design Control',
    description: 'Run a design toolbar, annotation, send or markup control in the mounted Browser pane whose id quirky browser pane state lists. annotation is the number its pin shows; session and agent come from quirky browser design targets. Returns how many mounted panes received it.',
    palette: false,
    args: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: designActions },
        pane: { type: 'string' },
        annotation: { type: 'integer', minimum: 1, maximum: 20 },
        intent: { type: 'string', enum: ['change', 'question'] },
        session: { type: 'string' },
        agent: { type: 'string' },
        tool: { type: 'string', enum: markupTools }
      },
      required: ['action', 'pane'],
      additionalProperties: false
    }
  })
  expect(designControls.DESIGN_CONTROL_COMMAND).toBe(designCommand)
  expect(designControls.DESIGN_CONTROL_ACTIONS).toEqual(designActions)
  expect(designControls.MARKUP_TOOLS).toEqual(markupTools)
})

test('delivers a design action only to the addressed pane', () => {
  const ctx = context()
  const first: unknown[] = [], second: unknown[] = []
  designControls.registerDesignController(ctx, 'pane-1', args => first.push(args))
  designControls.registerDesignController(ctx, 'pane-2', args => second.push(args))
  const args = { action: 'toggle-grab', pane: 'pane-2' } as const
  expect(designControls.dispatchDesignControl(ctx, args)).toEqual({ pane: 'pane-2', action: 'toggle-grab', delivered: 1 })
  expect(first).toEqual([])
  expect(second).toEqual([args])
})

test('routes markup actions only to markup controllers and reports no overlay after cleanup', () => {
  const ctx = context()
  const designCalls: unknown[] = [], markupCalls: unknown[] = []
  designControls.registerDesignController(ctx, 'pane-1', args => designCalls.push(args))
  const cleanup = designControls.registerMarkupController(ctx, 'pane-1', args => markupCalls.push(args))

  expect(designControls.dispatchDesignControl(ctx, { action: 'markup-undo', pane: 'pane-1' })).toEqual({ pane: 'pane-1', action: 'markup-undo', delivered: 1 })
  expect(markupCalls).toEqual([{ action: 'markup-undo', pane: 'pane-1' }])
  expect(designCalls).toEqual([])
  expect(designControls.dispatchDesignControl(ctx, { action: 'toggle-grab', pane: 'pane-1' })).toEqual({ pane: 'pane-1', action: 'toggle-grab', delivered: 1 })
  expect(designCalls).toEqual([{ action: 'toggle-grab', pane: 'pane-1' }])
  expect(markupCalls).toHaveLength(1)

  cleanup()
  expect(designControls.dispatchDesignControl(ctx, { action: 'markup-undo', pane: 'pane-1' })).toEqual({ pane: 'pane-1', action: 'markup-undo', delivered: 0 })
  expect(designCalls).toHaveLength(1)
  expect(markupCalls).toHaveLength(1)
})

test('counts multiple design registrations for a pane and removes only the cleaned one', () => {
  const ctx = context()
  const calls: string[] = []
  const cleanupFirst = designControls.registerDesignController(ctx, 'pane-1', () => calls.push('first'))
  designControls.registerDesignController(ctx, 'pane-1', () => calls.push('second'))
  const args = { action: 'toggle-grab', pane: 'pane-1' } as const
  expect(designControls.dispatchDesignControl(ctx, args)).toEqual({ ...args, delivered: 2 })
  expect(calls).toEqual(['first', 'second'])
  cleanupFirst()
  expect(designControls.dispatchDesignControl(ctx, args)).toEqual({ ...args, delivered: 1 })
  expect(calls).toEqual(['first', 'second', 'second'])
})

test('isolates design registrations by context', () => {
  const registeredContext = context(), otherContext = context()
  const calls: unknown[] = []
  designControls.registerDesignController(registeredContext, 'pane-1', args => calls.push(args))
  const args = { action: 'toggle-grab', pane: 'pane-1' } as const
  expect(designControls.dispatchDesignControl(otherContext, args)).toEqual({ ...args, delivered: 0 })
  expect(calls).toEqual([])
})

test('reports missing and unmounted design panes without delivery', () => {
  const ctx = context()
  const calls: unknown[] = []
  designControls.registerDesignController(ctx, 'pane-3', args => calls.push(args))()
  for (const pane of ['pane-9', 'pane-3']) {
    expect(designControls.dispatchDesignControl(ctx, { action: 'toggle-grab', pane })).toEqual({ pane, action: 'toggle-grab', delivered: 0 })
  }
  expect(calls).toEqual([])
})

test('rejects malformed design payloads with the exact error before delivery', () => {
  const ctx = context()
  const calls: unknown[] = []
  designControls.registerDesignController(ctx, 'pane-1', args => calls.push(args))
  designControls.registerMarkupController(ctx, 'pane-1', args => calls.push(args))
  const invalid = [
    undefined, null, 'toggle-grab', {}, { pane: 'pane-1' }, { action: 'explode', pane: 'pane-1' },
    { action: 'toggle-grab', pane: '' }, { action: 'toggle-grab', pane: 7 },
    { action: 'edit-annotation', pane: 'pane-1' }, { action: 'edit-annotation', pane: 'pane-1', annotation: 0 },
    { action: 'edit-annotation', pane: 'pane-1', annotation: 21 }, { action: 'edit-annotation', pane: 'pane-1', annotation: 1.5 },
    { action: 'edit-annotation', pane: 'pane-1', annotation: '1' },
    { action: 'set-intent', pane: 'pane-1', intent: 'maybe' }, { action: 'set-intent', pane: 'pane-1' },
    { action: 'send-annotations', pane: 'pane-1' },
    { action: 'send-annotations', pane: 'pane-1', session: 's', agent: 'a' },
    { action: 'send-annotations', pane: 'pane-1', session: '' },
    { action: 'send-annotations', pane: 'pane-1', agent: '' },
    { action: 'markup-tool', pane: 'pane-1', tool: 'laser' }, { action: 'markup-tool', pane: 'pane-1' }
  ]
  const message = 'Browser design control needs a known action, a non-empty pane id and the fields that action takes.'
  for (const args of invalid) {
    let thrown: unknown
    try {
      designControls.dispatchDesignControl(ctx, args)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe(message)
  }
  expect(calls).toEqual([])
})

test('drops fields that the selected design action does not take', () => {
  const ctx = context()
  const designCalls: unknown[] = [], markupCalls: unknown[] = []
  designControls.registerDesignController(ctx, 'pane-1', args => designCalls.push(args))
  designControls.registerMarkupController(ctx, 'pane-1', args => markupCalls.push(args))

  designControls.dispatchDesignControl(ctx, { action: 'toggle-grab', pane: 'pane-1', annotation: 3, extra: 1 })
  designControls.dispatchDesignControl(ctx, { action: 'send-annotations', pane: 'pane-1', session: 's-1', tool: 'pen' })
  designControls.dispatchDesignControl(ctx, { action: 'edit-annotation', pane: 'pane-1', annotation: 2, intent: 'change' })
  designControls.dispatchDesignControl(ctx, { action: 'markup-tool', pane: 'pane-1', tool: 'text', annotation: 1 })

  expect(designCalls).toEqual([
    { action: 'toggle-grab', pane: 'pane-1' },
    { action: 'send-annotations', pane: 'pane-1', session: 's-1' },
    { action: 'edit-annotation', pane: 'pane-1', annotation: 2 }
  ])
  expect(markupCalls).toEqual([{ action: 'markup-tool', pane: 'pane-1', tool: 'text' }])
})

test('requests the design command without activating its owner and preserves failures', async () => {
  const calls: unknown[] = []
  const ctx = { executeCommand: async (...args: unknown[]) => { calls.push(args) } } as unknown as UiPluginContext
  const args = { action: 'markup-undo', pane: 'pane-1' } as const
  await designControls.requestDesignControl(ctx, args)
  expect(calls).toEqual([[designCommand, args, { activateOwner: false }]])
  const failure = new Error('No command')
  const rejected = { executeCommand: async () => { throw failure } } as unknown as UiPluginContext
  await expect(designControls.requestDesignControl(rejected, args)).rejects.toBe(failure)
})
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
