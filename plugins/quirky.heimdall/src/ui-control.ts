import type { UiPluginContext } from '@quirky/protocol'

export const UI_CONTROL_COMMAND = 'command:quirky.heimdall/uiControl'
export const UI_CONTROL_ACTIONS = ['edit-budget', 'cancel-budget', 'cancel-concurrency'] as const

export type FleetControlAction = typeof UI_CONTROL_ACTIONS[number]
/** revision is budgetEditorRevision for edit-budget and cancel-budget, concurrencyRevision for cancel-concurrency: a non-negative safe integer. */
export type FleetControlArgs = { action: FleetControlAction; instance: string; generation: string; revision: number }
export type FleetControlResult = FleetControlArgs & { delivered: 0 | 1 }

/** Registers the mounted view's handler; the handler returns true only when it applied the control. */
export function registerFleetControl(
  context: UiPluginContext,
  instance: string,
  handler: (args: FleetControlArgs) => boolean
): () => void {
  let registrations = registrationsByContext.get(context)
  if (!registrations) {
    registrations = new Map()
    registrationsByContext.set(context, registrations)
  }

  const registration = { handler }
  registrations.set(instance, registration)
  return () => {
    if (registrations?.get(instance) !== registration) return
    registrations.delete(instance)
    if (registrations.size === 0) registrationsByContext.delete(context)
  }
}

/** Validates and delivers controls synchronously to the exact mounted instance. */
export function dispatchFleetControl(context: UiPluginContext, args: unknown): FleetControlResult {
  const normalized = normalizeFleetControlArgs(args)
  const registration = registrationsByContext.get(context)?.get(normalized.instance)
  const delivered = registration?.handler(normalized) === true ? 1 : 0
  return { ...normalized, delivered }
}

type FleetControlDescriptor = { command: typeof UI_CONTROL_COMMAND; args: FleetControlArgs }

function fleetControlDescriptor(args: FleetControlArgs): FleetControlDescriptor {
  return { command: UI_CONTROL_COMMAND, args }
}

/** Sends a control to this context's own window; malformed replies and transport errors reject. */
export async function requestFleetControl(context: UiPluginContext, args: FleetControlArgs): Promise<FleetControlResult> {
  const normalized = normalizeFleetControlArgs(args)
  const self = await context.call('ui.window.self', {})
  const connId = typeof self === 'object' && self !== null && !Array.isArray(self)
    ? (self as Record<string, unknown>).connId
    : undefined
  if (typeof connId !== 'number' || !Number.isSafeInteger(connId) || connId < 1) {
    throw new Error('ui.window.self returned an invalid connection identity.')
  }

  const descriptor = fleetControlDescriptor(normalized)
  const reply = await context.call('ui.window.command.run', {
    connId,
    id: descriptor.command,
    args: descriptor.args
  })
  if (typeof reply !== 'object' || reply === null || Array.isArray(reply)) return invalidReply()
  const replyValue = reply as Record<string, unknown>
  if (!hasExactKeys(replyValue, ['result'])) return invalidReply()

  const result = replyValue.result
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return invalidReply()
  const resultValue = result as Record<string, unknown>
  const delivered = resultValue.delivered
  if (
    !hasExactKeys(resultValue, ['action', 'instance', 'generation', 'revision', 'delivered']) ||
    resultValue.action !== normalized.action || resultValue.instance !== normalized.instance ||
    resultValue.generation !== normalized.generation || resultValue.revision !== normalized.revision ||
    (delivered !== 0 && delivered !== 1)
  ) return invalidReply()

  return { ...normalized, delivered }
}

const registrationsByContext = new WeakMap<UiPluginContext, Map<string, { handler: (args: FleetControlArgs) => boolean }>>()
const INVALID_ARGS = 'Heimdall UI control needs a known action, instance, generation and revision.'
const INVALID_REPLY = 'The window returned an invalid Heimdall UI control result.'
const ARG_KEYS = ['action', 'instance', 'generation', 'revision'] as const

function normalizeFleetControlArgs(raw: unknown): FleetControlArgs {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return invalidArgs()
  const value = raw as Record<string, unknown>
  if (!hasExactKeys(value, ARG_KEYS)) return invalidArgs()
  if (!(UI_CONTROL_ACTIONS as readonly unknown[]).includes(value.action)) return invalidArgs()
  if (typeof value.instance !== 'string' || value.instance.trim() === '') return invalidArgs()
  if (typeof value.generation !== 'string' || value.generation.trim() === '') return invalidArgs()
  if (typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0) return invalidArgs()

  return {
    action: value.action as FleetControlAction,
    instance: value.instance,
    generation: value.generation,
    revision: value.revision
  }
}


function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value)
  return keys.length === expected.length && keys.every((key) => typeof key === 'string' && expected.includes(key))
}

function invalidArgs(): never {
  throw new Error(INVALID_ARGS)
}

function invalidReply(): never {
  throw new Error(INVALID_REPLY)
}
