import { readFileSync } from 'node:fs'
import { expect, test } from 'bun:test'
import type { UiPluginContext } from '@quirky/protocol'
import * as shared from '../src/preferences-window/shared'
import { registerPreferencesUi } from '../src/preferences-ui'

const COMMAND_ID = 'command:quirky.browser/preferencesControl'
const INVALID_ARGS_MESSAGE = 'Browser preferences control needs a known action and a non-empty instance.'
const MISSING_PROFILE_MESSAGE = 'Browser preferences control toggle-import needs a profile.'
type ControlArgs = { action: string; instance: string; profile?: string }
type Handler = (args: unknown) => unknown

function makeContext(): { context: UiPluginContext; handlers: Map<string, unknown> } {
  const handlers = new Map<string, unknown>()
  const context = {
    provide: (id: string, implementation: unknown) => handlers.set(id, implementation)
  } as unknown as UiPluginContext
  return { context, handlers }
}

function controllerApi(): {
  register: (context: UiPluginContext, instance: string, handler: (args: ControlArgs) => void) => () => void
  dispatch: (context: UiPluginContext, args: unknown) => unknown
} {
  const register = Reflect.get(shared, 'registerPreferencesController')
  const dispatch = Reflect.get(shared, 'dispatchPreferencesControl')
  if (typeof register !== 'function' || typeof dispatch !== 'function') {
    throw new Error('Browser preferences control registry exports are unavailable.')
  }
  return {
    register: register as (context: UiPluginContext, instance: string, handler: (args: ControlArgs) => void) => () => void,
    dispatch: dispatch as (context: UiPluginContext, args: unknown) => unknown
  }
}

function controlCommand(handlers: Map<string, unknown>): Handler {
  const handler = handlers.get(COMMAND_ID)
  if (typeof handler !== 'function') throw new Error(`Missing provided command: ${COMMAND_ID}`)
  return handler as Handler
}


test('registers the hidden preferences control command with the exact manifest contract', () => {
  const { context, handlers } = makeContext()
  registerPreferencesUi(context)
  expect(typeof handlers.get(COMMAND_ID)).toBe('function')

  const manifest = JSON.parse(readFileSync(new URL('../quirky-plugin.json', import.meta.url), 'utf8')) as {
    contributes?: { command?: unknown[] }
  }
  const declaration = manifest.contributes?.command?.find((candidate) => {
    return typeof candidate === 'object' && candidate !== null && Reflect.get(candidate, 'id') === 'preferencesControl'
  })
  expect(declaration).toEqual({
    id: 'preferencesControl',
    title: 'Browser Preferences UI Control',
    description: 'Open or close a Browser settings dialog or import panel.',
    palette: false,
    args: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['open-create-profile', 'close-create-profile', 'toggle-import', 'open-file-import', 'close-file-import', 'toggle-profile-menu', 'toggle-import-hint'] },
        instance: { type: 'string' },
        profile: { type: 'string' }
      },
      required: ['action', 'instance']
    }
  })
})

test('routes a control command to only the controller matching its instance', () => {
  const { context, handlers } = makeContext()
  registerPreferencesUi(context)
  const { register } = controllerApi()
  const receivedA: ControlArgs[] = []
  const receivedB: ControlArgs[] = []
  register(context, 'a', (args) => receivedA.push(args))
  register(context, 'b', (args) => receivedB.push(args))

  const args = { action: 'open-create-profile', instance: 'a' }
  expect(controlCommand(handlers)(args)).toEqual({ instance: 'a', action: 'open-create-profile', delivered: 1 })
  expect(receivedA).toEqual([args])
  expect(receivedB).toEqual([])
})

test('a stale cleanup preserves a replacement registration with the same instance and handler', () => {
  const { context } = makeContext()
  const { register, dispatch } = controllerApi()
  const received: ControlArgs[] = []
  const handler = (args: ControlArgs) => { received.push(args) }
  const cleanupOriginal = register(context, 'a', handler)
  const cleanupReplacement = register(context, 'a', handler)
  const args = { action: 'open-create-profile', instance: 'a' }

  cleanupOriginal()
  expect(dispatch(context, args)).toEqual({ instance: 'a', action: 'open-create-profile', delivered: 1 })
  expect(received).toEqual([args])

  cleanupReplacement()
  expect(dispatch(context, args)).toEqual({ instance: 'a', action: 'open-create-profile', delivered: 0 })
  expect(received).toEqual([args])
})

test('keeps controller registries isolated by context', () => {
  const { context: contextX } = makeContext()
  const { context: contextY, handlers } = makeContext()
  registerPreferencesUi(contextY)
  const { register } = controllerApi()
  const received: ControlArgs[] = []
  register(contextX, 'a', (args) => received.push(args))

  expect(controlCommand(handlers)({ action: 'open-create-profile', instance: 'a' })).toEqual({
    instance: 'a', action: 'open-create-profile', delivered: 0
  })
  expect(received).toEqual([])
})

test('silently ignores unknown and already-unmounted instances', () => {
  const { context, handlers } = makeContext()
  registerPreferencesUi(context)
  const { register } = controllerApi()
  const received: ControlArgs[] = []
  const cleanup = register(context, 'gone', (args) => received.push(args))
  cleanup()
  const command = controlCommand(handlers)

  expect(command({ action: 'close-file-import', instance: 'ghost' })).toEqual({
    instance: 'ghost', action: 'close-file-import', delivered: 0
  })
  expect(command({ action: 'close-file-import', instance: 'gone' })).toEqual({
    instance: 'gone', action: 'close-file-import', delivered: 0
  })
  expect(received).toEqual([])
})

test('rejects malformed command payloads synchronously with the contract error', () => {
  const { context, handlers } = makeContext()
  registerPreferencesUi(context)
  const { register } = controllerApi()
  const received: ControlArgs[] = []
  register(context, 'a', (args) => received.push(args))
  const command = controlCommand(handlers)
  const malformed: unknown[] = [
    undefined,
    null,
    'open-create-profile',
    {},
    { instance: 'a' },
    { action: 'explode', instance: 'a' },
    { action: 'open-create-profile', instance: '' },
    { action: 'open-create-profile', instance: 7 }
  ]

  for (const args of malformed) {
    let thrown: unknown
    try {
      command(args)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error | undefined)?.message).toBe(INVALID_ARGS_MESSAGE)
  }
  expect(received).toEqual([])
})

test('requires a string profile for toggle-import and forwards it only when valid', () => {
  const { context, handlers } = makeContext()
  registerPreferencesUi(context)
  const { register } = controllerApi()
  const received: ControlArgs[] = []
  register(context, 'a', (args) => received.push(args))
  const command = controlCommand(handlers)

  for (const args of [
    { action: 'toggle-import', instance: 'a' },
    { action: 'toggle-import', instance: 'a', profile: '' },
    { action: 'toggle-import', instance: 'a', profile: 3 }
  ]) {
    let thrown: unknown
    try {
      command(args)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error | undefined)?.message).toBe(MISSING_PROFILE_MESSAGE)
  }

  const valid = { action: 'toggle-import', instance: 'a', profile: 'default' }
  expect(command(valid)).toEqual({ instance: 'a', action: 'toggle-import', delivered: 1 })
  expect(received).toEqual([valid])
})

test('routes profile menu and import hint controls without unused keys', () => {
  const { context } = makeContext()
  const { dispatch, register } = controllerApi()
  const received: ControlArgs[] = []
  register(context, 'a', (args) => received.push(args))

  expect(dispatch(context, { action: 'toggle-profile-menu', instance: 'a', profile: 'x' })).toEqual({
    instance: 'a', action: 'toggle-profile-menu', delivered: 1
  })
  expect(dispatch(context, { action: 'toggle-import-hint', instance: 'a', profile: 'x' })).toEqual({
    instance: 'a', action: 'toggle-import-hint', delivered: 1
  })
  expect(received).toEqual([
    { action: 'toggle-profile-menu', instance: 'a' },
    { action: 'toggle-import-hint', instance: 'a' }
  ])
})

test('delivers a preferences control to every registration for its instance', () => {
  const { context, handlers } = makeContext()
  registerPreferencesUi(context)
  const { register } = controllerApi()
  const receivedA: ControlArgs[] = []
  const receivedB: ControlArgs[] = []
  register(context, 'a', (args) => receivedA.push(args))
  register(context, 'a', (args) => receivedB.push(args))

  expect(controlCommand(handlers)({ action: 'open-create-profile', instance: 'a' })).toEqual({
    instance: 'a', action: 'open-create-profile', delivered: 2
  })
  expect(receivedA).toEqual([{ action: 'open-create-profile', instance: 'a' }])
  expect(receivedB).toEqual([{ action: 'open-create-profile', instance: 'a' }])
})

test('drops unused command keys before calling a controller', () => {
  const { context, handlers } = makeContext()
  registerPreferencesUi(context)
  const { register } = controllerApi()
  const received: ControlArgs[] = []
  register(context, 'a', (args) => received.push(args))

  expect(controlCommand(handlers)({ action: 'open-create-profile', instance: 'a', profile: 'default', extra: 1 })).toEqual({
    instance: 'a', action: 'open-create-profile', delivered: 1
  })
  expect(received).toEqual([{ action: 'open-create-profile', instance: 'a' }])
})
