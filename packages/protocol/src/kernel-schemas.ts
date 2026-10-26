import type { MethodName, QuirkyEvent } from './rpc'
import type { PluginEvent } from './plugins'
import type { Schema } from './schema'

export type KernelEventType = Exclude<QuirkyEvent, PluginEvent>['type']

/** Kernel methods that act on the calling connection itself, so only a live client can call them. */
export const CONNECTION_METHODS = ['client.hello', 'events.subscribe', 'terminal.attach', 'terminal.detach'] as const

/** Every kernel method's params and result schema; `params` never rejects what the handler accepts. */
export const KERNEL_METHOD_SCHEMAS = {} as { [M in MethodName]: { description: string; params: Schema; result: Schema } }

/** Every kernel event's data schema: the event object without its `type`. */
export const KERNEL_EVENT_SCHEMAS = {} as { [T in KernelEventType]: { description: string; data: Schema } }
